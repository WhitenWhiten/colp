import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createCreditTestDatabase } from '../../support/credit-ledger-fixture.js';
import {
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { countRows, seedCreditAccount } from '../../support/credit-ledger-fixture.js';

const CREDIT_SCHEMA = 'known_credits';
const CREDIT_TABLES = [
  'credit_accounts',
  'credit_grants',
  'credit_charges',
  'credit_allocations',
  'credit_ledger_entries',
] as const;
const CREDIT_FUNCTIONS = [
  'grant_credits',
  'refund_credit_charge',
  'reconcile_expired_credits',
] as const;

type TestRole = 'app' | 'ops';

describeWithPostgres('CR01 credit ledger database permissions', () => {
  let isolated: IsolatedPostgresRuntime;
  let appRole: string;
  let opsRole: string;
  let accountId: string;
  let grantId: string;

  beforeAll(async () => {
    isolated = await createCreditTestDatabase('credit_permissions', 8);
    await isolated.runtime.pool.query(`do $block$
      begin
        if to_regrole('known_credits_app') is null then
          create role known_credits_app nologin;
        end if;
        if to_regrole('known_credits_operator') is null then
          create role known_credits_operator nologin;
        end if;
      end
    $block$`);
    await runMigrations(isolated.runtime.db, 'latest');
    appRole = `credit_app_${randomUUID().replaceAll('-', '')}`;
    opsRole = `credit_ops_${randomUUID().replaceAll('-', '')}`;
    await isolated.runtime.pool.query(`create role ${quoteIdent(appRole)} nologin`);
    await isolated.runtime.pool.query(`create role ${quoteIdent(opsRole)} nologin`);
    await isolated.runtime.pool.query(`grant known_credits_operator to ${quoteIdent(opsRole)}`);
    await isolated.runtime.pool.query(`grant known_credits_app to ${quoteIdent(appRole)}`);

    accountId = (await seedCreditAccount(isolated.runtime.db, 'permission')).accountId;

    const funding = await asRole('ops', async (client) => client.query<{ grant_id: string }>(
      `select grant_id::text from ${CREDIT_SCHEMA}.grant_credits(
        $1, $2, $3::bigint, current_timestamp, null, 'operator', 'manual_grant', $4
      )`,
      [accountId, `permission-${accountId}`, 7, 'CR01 permission fixture'],
    ), true);
    grantId = funding.rows[0]?.grant_id ?? '';
    assert.match(grantId, /^[0-9a-f-]{36}$/u);
  }, 180_000);

  afterAll(async () => {
    if (!isolated) return;
    if (opsRole) await isolated.runtime.pool.query(`revoke known_credits_operator from ${quoteIdent(opsRole)}`);
    for (const role of [appRole, opsRole].filter(Boolean)) {
      await isolated.runtime.pool.query(`drop owned by ${quoteIdent(role)}`);
      await isolated.runtime.pool.query(`drop role if exists ${quoteIdent(role)}`);
    }
    await isolated.close();
  });

  test('operator functions are executable while PUBLIC and the application role cannot call funding or refund', async () => {
    const functions = await isolated.runtime.pool.query<{
      name: string; security_definer: boolean; config: string[] | null; public_execute: boolean; operator_execute: boolean;
    }>(`
      select p.proname as name, p.prosecdef as security_definer, p.proconfig as config,
             exists (
               select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
             ) as public_execute,
             has_function_privilege($2, p.oid, 'EXECUTE') as operator_execute
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = $1 and p.proname = any($3::text[])
    `, [CREDIT_SCHEMA, opsRole, [...CREDIT_FUNCTIONS]]);
    assert.deepEqual(new Set(functions.rows.map((row) => row.name)), new Set(CREDIT_FUNCTIONS));
    for (const row of functions.rows) {
      assert.equal(row.security_definer, true, `${row.name} must isolate its owner privileges`);
      assert.equal(row.public_execute, false, `${row.name} must revoke PUBLIC EXECUTE`);
      assert.equal(row.operator_execute, true, `${row.name} must be executable by the operator role`);
      assert.ok(row.config?.some((entry) => /^search_path=/u.test(entry)), `${row.name} must pin search_path`);
      assert.ok(!row.config?.some((entry) => /(?:current_user|\$user)/iu.test(entry)), `${row.name} must not use caller search_path`);
    }

    const appGrant = `select ${CREDIT_SCHEMA}.grant_credits($1,$2,$3::bigint,current_timestamp,null,'operator','manual_grant','app')`;
    const appRefund = `select ${CREDIT_SCHEMA}.refund_credit_charge($1,$2,$3::uuid,$4::bigint,null,'app')`;
    await assert.rejects(
      () => asRole('app', (client) => client.query(appGrant, [accountId, `app-${accountId}`, 1]), false),
      /permission denied for function grant_credits/iu,
    );
    await assert.rejects(
      () => asRole('app', (client) => client.query(appRefund, [accountId, `app-refund-${accountId}`, randomUUID(), 1]), false),
      /permission denied for function refund_credit_charge/iu,
    );

    await assert.rejects(
      () => asRole('ops', (client) => client.query(appRefund, [accountId, `bad-refund-${accountId}`, randomUUID(), 1]), false),
      (error: unknown) => (error as { code?: string; message?: string }).code === 'P0001'
        && (error as { message?: string }).message === 'credit_charge_not_refundable',
    );
    await asRole('ops', (client) => client.query(
      `select * from ${CREDIT_SCHEMA}.reconcile_expired_credits($1)`, [accountId],
    ), false);
  });

  test('application and operator roles have no direct ledger mutation privileges', async () => {
    const privilegeRows = await isolated.runtime.pool.query<{
      role_name: string; table_name: string; privilege: string; allowed: boolean;
    }>(`
      select role_name, table_name, privilege,
             has_table_privilege(role_name, format('%I.%I', current_schema(), table_name), privilege) as allowed
        from unnest($1::text[]) as role_name
        cross join unnest($2::text[]) as table_name
        cross join unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as privilege
    `, [[appRole, opsRole], [...CREDIT_TABLES]]);
    assert.ok(privilegeRows.rows.every((row) => row.allowed === false),
      JSON.stringify(privilegeRows.rows.filter((row) => row.allowed)));

    for (const role of ['app', 'ops'] as const) {
      for (const table of CREDIT_TABLES) {
        await assert.rejects(
          () => asRole(role, (client) => client.query(`update ${quoteIdent(table)} set account_id = account_id where false`), false),
          /permission denied for table|permission denied for relation/iu,
        );
        await assert.rejects(
          () => asRole(role, (client) => client.query(`delete from ${quoteIdent(table)} where false`), false),
          /permission denied for table|permission denied for relation/iu,
        );
      }
    }
  });

  test('grant originals and ledger entries remain immutable even for the migration owner', async () => {
    for (const statement of [
      `update credit_grants set amount = amount + 1 where id = $1`,
      `update credit_grants set grant_key = grant_key || '-changed' where id = $1`,
      `update credit_grants set valid_from = valid_from + interval '1 minute' where id = $1`,
      `update credit_ledger_entries set points_delta = points_delta + 1 where grant_id = $1`,
      `delete from credit_ledger_entries where grant_id = $1`,
    ]) {
      await assert.rejects(
        () => rollbackQuery(statement, [grantId]),
        /immutable|append.?only|credit_(grant|ledger)|check constraint|permission denied|function-owned/iu,
      );
    }
  });

  test('soft deleting the account does not deadlock or cascade away its private ledger', async () => {
    await isolated.runtime.pool.query(
      `update accounts set status = 'deleted', deleted_at = current_timestamp, email = null where id = $1`,
      [accountId],
    );
    assert.equal(await countRows(isolated.runtime.db, 'credit_grants', accountId), 1);
    assert.equal(await countRows(isolated.runtime.db, 'credit_ledger_entries', accountId), 1);
  });

  test('permanent private-ledger cleanup can delete an isolated account without FK deadlock', async () => {
    const cleanupAccount = (await seedCreditAccount(isolated.runtime.db, 'permanent-cleanup')).accountId;
    await isolated.runtime.pool.query(
      `select * from ${CREDIT_SCHEMA}.grant_credits($1,$2,1::bigint,current_timestamp,null,'operator','manual_grant','cleanup')`,
      [cleanupAccount, `cleanup-${cleanupAccount}`],
    );
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("update accounts set status='deleted',deleted_at=clock_timestamp() where id=$1",[cleanupAccount]);
      await client.query(`select set_config('known.credits_account_delete',$1,true)`,[cleanupAccount]);
      await client.query('delete from accounts where id = $1', [cleanupAccount]);
      await client.query('commit');
    } catch (error) {
      try { await client.query('rollback'); } catch { /* preserve the assertion's original error */ }
      throw error;
    } finally {
      client.release();
    }
    assert.equal(await countRows(isolated.runtime.db, 'credit_accounts', cleanupAccount), 0);
    assert.equal(await countRows(isolated.runtime.db, 'credit_grants', cleanupAccount), 0);
    assert.equal(await countRows(isolated.runtime.db, 'credit_ledger_entries', cleanupAccount), 0);
  });

  async function asRole<Result>(role: TestRole, work: (client: import('pg').PoolClient) => Promise<Result>, commit: boolean): Promise<Result> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local session authorization ${quoteIdent(role === 'app' ? appRole : opsRole)}`);
      const result = await work(client);
      if (commit) await client.query('commit');
      else await client.query('rollback');
      return result;
    } catch (error) {
      try { await client.query('rollback'); } catch { /* preserve the assertion's original error */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async function rollbackQuery(statement: string, parameters: readonly unknown[]): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      // A preceding financial function authorizes counter writes in this
      // transaction; it must still never authorize rewriting original facts.
      await client.query("select set_config('known.credits_internal_xact',txid_current()::text,true)");
      await client.query(statement, [...parameters]);
      await client.query('rollback');
    } catch (error) {
      try { await client.query('rollback'); } catch { /* preserve the assertion's original error */ }
      throw error;
    } finally {
      client.release();
    }
  }
});

function quoteIdent(value: string): string {
  assert.match(value, /^[a-z_][a-z0-9_]*$/u);
  return `"${value}"`;
}
