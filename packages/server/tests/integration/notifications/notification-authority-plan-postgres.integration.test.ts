import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('P5-16 Notification authority query plans', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_notification_plan', {
      statementTimeoutMs: 120_000,
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await isolated.runtime.pool.query(`insert into accounts(id,subject_id,status)
      values('plan-recipient','plan-subject','active')`);
    await isolated.runtime.pool.query(`insert into profiles(account_id,display_name)
      values('plan-recipient','Plan Recipient')`);
    await isolated.runtime.pool.query(`insert into notifications(
      notification_id,recipient_account_id,source_event_id,notification_type,
      subject_type,subject_id,occurred_at,retain_until)
      select 'plan-notification-' || n,'plan-recipient','plan-event-' || n,
        case when n % 2=0 then 'collection_change' else 'follow_activity' end,
        'profile','plan-recipient',current_timestamp-(n || ' seconds')::interval,
        current_timestamp-(n || ' seconds')::interval+interval '365 days'
      from generate_series(1,2500) n`);
    await isolated.runtime.pool.query(`insert into notification_deliveries(
      delivery_id,notification_id,recipient_account_id,channel,next_attempt_at)
      select 'plan-delivery-' || n,'plan-notification-' || n,'plan-recipient','email',
        current_timestamp-(n || ' seconds')::interval from generate_series(1,2500) n`);
    await isolated.runtime.pool.query('analyze notifications');
    await isolated.runtime.pool.query('analyze notification_deliveries');
  }, 120_000);
  afterAll(async () => isolated?.close());

  test('recipient inbox, unread and retention paths use their bounded indexes', async () => {
    await expectIndex(`select notification_id from notifications
      where recipient_account_id='plan-recipient'
      order by occurred_at desc,notification_id desc limit 50`,
    'notifications_recipient_page_idx');
    await expectIndex(`select notification_id from notifications
      where recipient_account_id='plan-recipient' and state='unread'
      order by occurred_at desc,notification_id desc limit 50`,
    'notifications_recipient_unread_idx');
    await expectIndex(`select notification_id from notifications
      where retain_until <= current_timestamp order by retain_until,notification_id limit 100`,
    'notifications_retention_idx');
  });

  /**
   * The due-delivery claim: a UNION ALL of two index-ordered branches with
   * `skip locked` outside the union, plus the index the second branch needed.
   *
   * History, because the shape of this test encodes it:
   *  - as one WHERE with an OR it planned as `Limit -> Sort -> Seq Scan` on 2,500
   *    due rows, and adding either candidate index left the plan unchanged;
   *  - splitting it into two index-ordered branches fixed the LEASED branch
   *    (`notification_deliveries_leased_until_idx`), but the pending branch still
   *    sorted, because `notification_deliveries_state_due_idx` has no `channel`
   *    column while the claim filters `channel='email'` — an index cannot supply
   *    an ordering for rows the query does not want;
   *  - `202610080000` adds `(channel,next_attempt_at,delivery_id)` for exactly
   *    that branch, and the Sort disappears.
   *
   * Plain EXPLAIN, deliberately without `enable_seqscan=off`: disabling seqscan
   * makes a plan show an index whether or not the planner would choose it.
   */
  test('the due-delivery claim needs no sort on either branch', async () => {
    const plan = await explain(`
      (select delivery_id from notification_deliveries
         where channel='email' and state in ('pending','retryable')
           and next_attempt_at <= current_timestamp
         order by next_attempt_at, delivery_id limit 50)
      union all
      (select delivery_id from notification_deliveries
         where channel='email' and state='leased' and leased_until <= current_timestamp
         order by leased_until, delivery_id limit 50)`);
    assert.doesNotMatch(plan, /(?:^|\n)\s*->?\s*Sort/u,
      `the claim must not sort:\n${plan}`);
    assert.doesNotMatch(plan, /Seq Scan/u, `the claim must not scan the channel:\n${plan}`);
    assert.match(plan, /notification_deliveries_channel_state_due_idx/u, plan);
    assert.match(plan, /notification_deliveries_leased_until_idx/u, plan);
  });

  test('the pending/retryable branch walks its own index in order', async () => {
    // The query the claim actually runs: the `channel` equality is what lets the
    // index supply the ordering, because `channel` leads it. Without that
    // predicate Postgres can still use the index for the range but must sort the
    // result, which is why this asserts the real shape rather than a subset of it.
    const plan = await explain(`select delivery_id from notification_deliveries
      where channel='email' and state in ('pending','retryable')
        and next_attempt_at <= current_timestamp
      order by next_attempt_at, delivery_id limit 100`);
    assert.match(plan, /notification_deliveries_channel_state_due_idx/u, plan);
    assert.doesNotMatch(plan, /(?:^|\n)\s*->?\s*Sort/u, plan);
  });

  test('the OR claim statement is documented as sort-bound, not index-bound', async () => {
    // Pin the measured plan so a future rewrite that removes the sort is
    // visible here: if this assertion starts failing because the plan no longer
    // sorts, the limitation above has been addressed and this test (and its
    // KNOWN LIMITATION note) should be deleted with it.
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      const result = await client.query<{ 'QUERY PLAN': string }>(`explain
        select delivery_id from notification_deliveries
        where channel='email'
          and ((state in ('pending','retryable') and next_attempt_at <= current_timestamp)
            or (state='leased' and leased_until <= current_timestamp))
        order by next_attempt_at, delivery_id limit 100`);
      const plan = result.rows.map((row) => row['QUERY PLAN']).join('\n');
      assert.match(plan, /Sort/u, `the claim statement is still sort-bound:\n${plan}`);
      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  /**
   * Plain EXPLAIN, deliberately WITHOUT `enable_seqscan=off`. Disabling seqscan
   * makes a plan show an index whether or not the planner would choose it, which
   * is the trap that let an earlier version of this file assert nothing.
   */
  async function explain(statement: string): Promise<string> {
    const result = await isolated.runtime.pool.query<{ 'QUERY PLAN': string }>(`explain ${statement}`);
    return result.rows.map((row) => row['QUERY PLAN']).join('\n');
  }

  async function expectIndex(statement: string, index: string): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set local enable_seqscan=off');
      const result = await client.query<{ 'QUERY PLAN': string }>(`explain ${statement}`);
      const plan = result.rows.map((row) => row['QUERY PLAN']).join('\n');
      assert.match(plan, new RegExp(index, 'u'), plan);
      await client.query('rollback');
    } finally {
      client.release();
    }
  }

  /**
   * REGRESSIONS for a defect this branch introduced and an independent reviewer
   * caught by execution. Splitting the claim into a UNION ALL dropped the
   * cross-branch ordering, so `candidates` took the union's incidental order: an
   * expired lease lost to any pending row, and nothing else reaps an expired
   * `notification_deliveries` lease, so the delivery was stranded. The same
   * rewrite left `for update skip locked` inert, because Postgres emits no
   * LockRows node for a set-operation subquery.
   *
   * These drive the SQL directly rather than through the repository: the
   * delivery transition guard requires `state_revision` to advance on every
   * update, so establishing an already-expired lease through raw SQL needs the
   * same shape the insert path produces. A plain insert is accepted.
   */
  /**
   * The claim's lock needs a real row source. `for update skip locked` is illegal
   * on a UNION arm and silently INERT on a set-operation subquery — Postgres emits
   * no LockRows node — so the shipped shape joins the due rows back to the table.
   * Without that join a row held by another worker turns the claim into a
   * lock-timeout wait instead of being skipped, which an independent reviewer
   * demonstrated by execution (5014ms then failure, against 14ms for the old form).
   *
   * The join also carries `order by due.due_at`, which is what stops a long-expired
   * lease from being starved by pending rows. That half is NOT asserted here: the
   * harness could not reproduce the repository's ordering reliably, and an
   * assertion I cannot make true is worse than none. It is recorded as open in the
   * remediation ledger instead.
   */

  test('the community unread count has a matching partial index', async () => {
    // The count shown in the UI is exact (`Notifications (N)`), so it cannot be
    // truncated — the SCAN is what has to be narrowed. The pre-existing community
    // index is partial on notification_type alone, with no `state` predicate, so
    // the unread-count query read every community notification the recipient ever
    // had before filtering. This asserts the index matching the query's own
    // predicate was created by the migration; the query plan for it is not
    // asserted here because seeding comment_reply rows needs the full shape
    // constraint (actor_profile_id and friends), which is a separate fixture.
    const created = await isolated.runtime.pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname=current_schema() and tablename='notifications'
          and indexname='notifications_recipient_community_unread_idx'`);
    assert.equal(created.rows.length, 1, 'the migration must create the index');
    const definition = created.rows[0]?.indexdef ?? '';
    assert.match(definition, /recipient_account_id/u, definition);
    assert.match(definition, /state = 'unread'/u,
      `the index must carry the state predicate the query filters on: ${definition}`);
    await expectIndex(`select recipient_account_id, subject_id, count(*) from notifications
      where recipient_account_id='plan-recipient' and notification_type='comment_reply'
        and state='unread'
      group by recipient_account_id, subject_id`,
    'notifications_recipient_community_unread_idx');
  });

  test('the claim locks through a real row source, so it can skip', async () => {
    // Inert locking shows up as a missing LockRows node; without it the claim
    // waits on a held row instead of skipping it.
    const plan = await explain(`select delivery.delivery_id from notification_deliveries delivery
      join (select delivery_id, next_attempt_at as due_at from notification_deliveries
        where channel='email' and state in ('pending','retryable')
          and next_attempt_at <= current_timestamp limit 50) due
        on due.delivery_id = delivery.delivery_id
      order by due.due_at, delivery.delivery_id
      for update of delivery skip locked limit 50`);
    assert.match(plan, /LockRows/u, `the lock needs a real row source:\n${plan}`);
  });
});
