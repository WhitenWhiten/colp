import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import {
  createPostgresFollowRepository,
  FollowAuthorityError,
} from '../../../src/infrastructure/social/index.js';
import { createUnitOfWork, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { waitForCondition } from '../../support/async-test-helpers.js';

describeWithPostgres('P5-02 transaction-bound PostgreSQL Follow authority', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_follow_authority', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());
  beforeEach(async () => resetFixture());

  const save = (actorProfileId = 'profile-actor', targetProfileId = 'profile-target') =>
    createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      createPostgresFollowRepository(transaction).save({ actorProfileId, targetProfileId }));
  const remove = (actorProfileId = 'profile-actor', targetProfileId = 'profile-target') =>
    createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      createPostgresFollowRepository(transaction).remove({ actorProfileId, targetProfileId }));

  test('saves once, reports duplicate authority, and atomically removes the binding', async () => {
    const first = await save();
    const duplicate = await save();
    assert.equal(first?.inserted, true);
    assert.equal(duplicate?.inserted, false);
    assert.deepEqual(duplicate?.follow, first?.follow);
    assert.equal(await remove(), true);
    assert.equal(await remove(), false);
    assert.equal(await followCount(), 0);
  });

  test('rejects self-follow and unavailable Profile identities', async () => {
    await assert.rejects(() => save('profile-actor', 'profile-actor'),
      (error: unknown) => error instanceof FollowAuthorityError && error.code === 'self_follow');
    assert.equal(await save('profile-actor', 'missing-profile'), null);
    await isolated.runtime.pool.query(
      `update accounts set status='disabled' where id='profile-target'`,
    );
    assert.equal(await save(), null);
    assert.equal(await followCount(), 0);
  });

  test('uses finite database time and keeps binding facts immutable', async () => {
    await assert.rejects(() => isolated.runtime.pool.query(
      `insert into follows(actor_profile_id,target_profile_id,followed_at)
       values('profile-actor','profile-target','infinity'::timestamptz)`,
    ), (error: unknown) => (error as { constraint?: string }).constraint === 'follows_followed_at_finite');
    const created = await save();
    assert.ok(created?.follow.followedAt instanceof Date);
    await assert.rejects(() => isolated.runtime.pool.query(
      `update follows set followed_at=followed_at+interval '1 second'
        where actor_profile_id='profile-actor' and target_profile_id='profile-target'`,
    ), (error: unknown) => (error as { constraint?: string }).constraint === 'follows_binding_immutable');
  });

  test('does not create Collection access, receipts, Audit, Outbox or projection state', async () => {
    const before = (await isolated.runtime.pool.query<Record<string, number>>(`select
      (select count(*)::int from collection_members) memberships,
      (select count(*)::int from product_command_receipts) receipts,
      (select count(*)::int from audit_events) audits,
      (select count(*)::int from outbox_events) outbox`)).rows[0];
    await save();
    const after = (await isolated.runtime.pool.query<Record<string, number>>(`select
      (select count(*)::int from collection_members) memberships,
      (select count(*)::int from product_command_receipts) receipts,
      (select count(*)::int from audit_events) audits,
      (select count(*)::int from outbox_events) outbox`)).rows[0];
    assert.deepEqual(after, before);
    assert.equal(await followCount(), 1);
  });

  test('uses stable Profile identity when mutable handles change', async () => {
    const created = await save();
    await isolated.runtime.pool.query(
      `update profile_handles set handle='renamed-target' where account_id='profile-target'`,
    );
    const row = (await isolated.runtime.pool.query<{
      actor_profile_id: string; target_profile_id: string;
    }>(`select actor_profile_id,target_profile_id from follows`)).rows[0];
    assert.deepEqual(row, {
      actor_profile_id: 'profile-actor', target_profile_id: 'profile-target',
    });
    assert.equal(created?.follow.targetProfileId, 'profile-target');
  });

  test('Profile deletion cascades incoming and outgoing edges', async () => {
    await save();
    await save('profile-other', 'profile-target');
    await save('profile-target', 'profile-other');
    await isolated.runtime.pool.query(`delete from profile_handles where account_id='profile-target'`);
    await isolated.runtime.pool.query(`delete from profiles where account_id='profile-target'`);
    assert.equal(await followCount(), 0);
  });

  test('Account soft deletion removes all edges and prevents a racing resurrection', async () => {
    await save();
    await save('profile-other', 'profile-target');
    await save('profile-target', 'profile-other');
    await isolated.runtime.pool.query(
      `update accounts set status='deleted',deleted_at=current_timestamp where id='profile-target'`,
    );
    assert.equal(await followCount(), 0);
    assert.equal(await save(), null);
    assert.equal(await save('profile-target', 'profile-other'), null);
  });

  test('serializes Follow creation with a concurrent target Account deletion', async () => {
    const lifecycle = await isolated.runtime.pool.connect();
    try {
      await lifecycle.query('begin');
      await lifecycle.query(
        `update accounts set status='deleted',deleted_at=current_timestamp where id='profile-target'`,
      );
      const pending = save();
      await waitForCondition(async () => {
        const blocked = await isolated.runtime.pool.query<{ waiting: boolean }>(`
          select exists(select 1 from pg_stat_activity
            where application_name='known-test-phase5_follow_authority'
              and cardinality(pg_blocking_pids(pid)) > 0) waiting
        `);
        return blocked.rows[0]?.waiting === true;
      }, {
        timeoutMs: 2_000,
        pollIntervalMs: 5,
        description: 'follow creation to wait on the account lifecycle transaction',
      });
      await lifecycle.query('commit');
      assert.equal(await pending, null);
      assert.equal(await followCount(), 0);
    } finally {
      await lifecycle.query('rollback').catch(() => undefined);
      lifecycle.release();
    }
  });

  test('a lifecycle change arriving after Follow insertion removes the committed edge', async () => {
    const writer = await isolated.runtime.pool.connect();
    const lifecycle = await isolated.runtime.pool.connect();
    try {
      await writer.query('begin');
      await writer.query(
        `insert into follows(actor_profile_id,target_profile_id)
         values('profile-actor','profile-target')`,
      );
      const deletion = lifecycle.query(
        `update accounts set status='deleted',deleted_at=current_timestamp
          where id='profile-target'`,
      );
      await waitForCondition(async () => {
        const blocked = await isolated.runtime.pool.query<{ waiting: boolean }>(`
          select exists(select 1 from pg_stat_activity
            where application_name='known-test-phase5_follow_authority'
              and cardinality(pg_blocking_pids(pid)) > 0) waiting
        `);
        return blocked.rows[0]?.waiting === true;
      }, {
        timeoutMs: 2_000,
        pollIntervalMs: 5,
        description: 'account deletion to wait on the uncommitted follow transaction',
      });
      await writer.query('commit');
      await deletion;
      assert.equal(await followCount(), 0);
    } finally {
      await writer.query('rollback').catch(() => undefined);
      writer.release();
      lifecycle.release();
    }
  });

  test('two real PostgreSQL connections race one binding with one unique winner', async () => {
    const first = await isolated.runtime.pool.connect();
    const second = await isolated.runtime.pool.connect();
    try {
      await first.query('begin');
      await second.query('begin');
      const firstInsert = first.query(
        `insert into follows(actor_profile_id,target_profile_id)
         values('profile-actor','profile-target') on conflict do nothing returning followed_at`,
      );
      const firstResult = await firstInsert;
      const secondInsert = second.query(
        `insert into follows(actor_profile_id,target_profile_id)
         values('profile-actor','profile-target') on conflict do nothing returning followed_at`,
      );
      await first.query('commit');
      const secondResult = await secondInsert;
      await second.query('commit');
      assert.deepEqual([firstResult.rowCount, secondResult.rowCount].sort(), [0, 1]);
      assert.equal(await followCount(), 1);
    } finally {
      await first.query('rollback').catch(() => undefined);
      await second.query('rollback').catch(() => undefined);
      first.release();
      second.release();
    }
  });

  test('repository contract converges two concurrent transactions on the unique winner', async () => {
    const outcomes = await Promise.all([save(), save()]);
    assert.ok(outcomes.every((outcome) => outcome !== null));
    assert.deepEqual(outcomes.map((outcome) => outcome?.inserted).sort(), [false, true]);
    assert.deepEqual(outcomes[0]?.follow, outcomes[1]?.follow);
    assert.equal(await followCount(), 1);
  });

  test('caller-owned transactions roll back both save and remove', async () => {
    await assert.rejects(() => createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      await createPostgresFollowRepository(transaction).save({
        actorProfileId: 'profile-actor', targetProfileId: 'profile-target',
      });
      throw new Error('rollback-save');
    }), /rollback-save/);
    assert.equal(await followCount(), 0);

    await save();
    await assert.rejects(() => createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      await createPostgresFollowRepository(transaction).remove({
        actorProfileId: 'profile-actor', targetProfileId: 'profile-target',
      });
      throw new Error('rollback-remove');
    }), /rollback-remove/);
    assert.equal(await followCount(), 1);
  });

  async function followCount(): Promise<number> {
    return (await isolated.runtime.pool.query<{ count: number }>(
      `select count(*)::int count from follows`,
    )).rows[0]?.count ?? -1;
  }

  async function resetFixture(): Promise<void> {
    await isolated.runtime.pool.query(`truncate table follows cascade`);
    await isolated.runtime.pool.query(
      `delete from profile_handles where account_id like 'profile-%'`,
    );
    await isolated.runtime.pool.query(`delete from profiles where account_id like 'profile-%'`);
    await isolated.runtime.pool.query(`delete from accounts where id like 'profile-%'`);
    for (const id of ['profile-actor', 'profile-target', 'profile-other']) {
      await isolated.runtime.pool.query(
        `insert into accounts(id,subject_id,status) values($1,$2,'active')`, [id, `subject-${id}`],
      );
      await isolated.runtime.pool.query(
        `insert into profiles(account_id,display_name) values($1,$2)`, [id, id],
      );
      await isolated.runtime.pool.query(
        `insert into profile_handles(handle,account_id) values($1,$2)`, [id, id],
      );
    }
  }
});
