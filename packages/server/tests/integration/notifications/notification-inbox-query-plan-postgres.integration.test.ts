import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { buildNotificationInboxPageStatement, buildNotificationUnreadCountStatement }
  from '../../../src/infrastructure/notifications/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('P5-18 Notification inbox query plans', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_notification_query_plan', {
      maxConnections: 4, statementTimeoutMs: 120_000 });
    await runMigrations(isolated.runtime.db, 'latest');
    for (const account of ['plan-a', 'plan-b']) {
      await isolated.runtime.pool.query(`insert into accounts(id,subject_id,status) values($1,$2,'active')`,
        [account, `subject-${account}`]);
      await isolated.runtime.pool.query(`insert into profiles(account_id,display_name) values($1,$2)`,
        [account, account]);
      await isolated.runtime.pool.query(`insert into notifications(notification_id,recipient_account_id,
        source_event_id,notification_type,subject_type,subject_id,occurred_at,retain_until)
        select $1||'-'||lpad(i::text,8,'0'),$1,'event-'||$1||'-'||i,
          case when i%2=0 then 'collection_change' else 'follow_activity' end,
          'collection','collection-'||i,
          '2026-07-29T12:00:00Z'::timestamptz-(i||' seconds')::interval,
          '2027-07-29T12:00:00Z'::timestamptz-(i||' seconds')::interval
        from generate_series(1,6000) i`, [account]);
      await isolated.runtime.pool.query(`update notifications set state='read',read_at=occurred_at+interval '1 second',
        state_revision=state_revision+1 where recipient_account_id=$1
        and right(notification_id,8)::int%2=0`, [account]);
    }
    await isolated.runtime.pool.query('analyze notifications');
  }, 180_000);
  afterAll(async () => isolated?.close());

  test('two-account first/middle/final pages use stable tuple indexes without Sort or Notification Seq Scan',
    async () => {
      for (const account of ['plan-a', 'plan-b']) for (const state of [undefined, 'read', 'unread'] as const) {
        const offsets = state ? [null, 1_500, 2_900] as const : [null, 3_000, 5_900] as const;
        for (const offset of offsets) {
          const boundary = offset === null ? null : (await isolated.runtime.pool.query<{
            occurred_at: Date; notification_id: string;
          }>(`select occurred_at,notification_id from notifications where recipient_account_id=$1
              ${state ? 'and state=$3' : ''} order by occurred_at desc,notification_id desc offset $2 limit 1`,
          state ? [account, offset, state] : [account, offset])).rows[0];
          assert.ok(offset === null || boundary, `${account}/${state ?? 'all'}/${offset} lacks boundary`);
          const statement = buildNotificationInboxPageStatement({ principalId: account, limit: 99,
            ...(state ? { state } : {}), ...(boundary ? { after: {
              occurredAt: boundary.occurred_at, notificationId: boundary.notification_id } } : {}) });
          const plan = await explain(statement.text, statement.values);
          assert.match(plan, state === 'unread'
            ? /notifications_recipient_unread_idx/u : /notifications_recipient_page_idx/u);
          assert.doesNotMatch(plan, /"Node Type":"Sort"/u);
          assert.doesNotMatch(plan, /"Node Type":"Seq Scan"[^}]*"Relation Name":"notifications"/u);
        }
      }
    }, 120_000);

  test('independent unread authority count uses the unread index for both accounts', async () => {
    for (const account of ['plan-a', 'plan-b']) {
      const statement = buildNotificationUnreadCountStatement(account);
      const plan = await explain(statement.text, statement.values);
      assert.match(plan, /notifications_recipient_unread_idx/u);
      assert.doesNotMatch(plan, /"Node Type":"Seq Scan"[^}]*"Relation Name":"notifications"/u);
    }
  });

  async function explain(text: string, values: readonly unknown[]) {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin'); await client.query('set local enable_seqscan=off');
      const result = await client.query<{ 'QUERY PLAN': unknown }>(
        `explain (analyze,buffers,format json) ${text}`, [...values]);
      await client.query('rollback'); return JSON.stringify(result.rows);
    } finally { client.release(); }
  }
});
