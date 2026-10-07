import { sql } from 'kysely';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import { createCreditUnitOfWork } from '../../../src/infrastructure/identity/credits-postgres.js';
import { createCreditTestDatabase, grantCredits, seedCreditAccount } from '../../support/credit-ledger-fixture.js';
import { describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

interface Issue { issue_code: string; issue_count: string }
const CORRUPTIONS = [
  ['grant_counters', 'UPDATE credit_grants SET spent_amount=spent_amount+1 WHERE account_id=$1'],
  ['grant_funding', 'UPDATE credit_grants SET amount=amount+1 WHERE account_id=$1'],
  ['charge_allocations', `UPDATE credit_allocations SET amount=amount+1
    WHERE charge_id=(SELECT id FROM credit_charges WHERE account_id=$1 LIMIT 1)`],
  ['charge_ledger', `DELETE FROM credit_ledger_entries
    WHERE id=(SELECT id FROM credit_ledger_entries WHERE account_id=$1 AND kind='reserve' LIMIT 1)`],
  ['charge_refunds', `UPDATE credit_charges SET refunded_amount=1
    WHERE id=(SELECT id FROM credit_charges WHERE account_id=$1 LIMIT 1)`],
  ['ledger_chain', `UPDATE credit_ledger_entries SET sequence=sequence+2
    WHERE id=(SELECT id FROM credit_ledger_entries WHERE account_id=$1 ORDER BY sequence DESC LIMIT 1)`],
  ['ledger_head', 'UPDATE credit_accounts SET last_sequence=last_sequence+1 WHERE account_id=$1'],
] as const;

describeWithPostgres('credit integrity audit scaling and historical equivalence', () => {
  let isolated: IsolatedPostgresRuntime;
  let legacyDefinition: string;
  let historyAccountId: string;
  let comparisonAccountId: string;

  beforeAll(async () => {
    isolated = await createCreditTestDatabase('credit_integrity_scaling', 3);
    // Capture the actual old migration output; do not maintain a second hand-written oracle.
    const baseline = await createMigrator(isolated.runtime.db).migrateTo('202610101000_classification_credit_integrity');
    if (baseline.error) throw baseline.error;
    const original = await sql<{ definition: string }>`SELECT
      pg_get_functiondef('credit_integrity_issues(text)'::regprocedure) AS definition`.execute(isolated.runtime.db);
    legacyDefinition = original.rows[0]!.definition
      .replace('FUNCTION public.credit_integrity_issues(', 'FUNCTION pg_temp.credit_integrity_issues_legacy(')
      .replace('SECURITY DEFINER', 'SECURITY INVOKER');
    if (!legacyDefinition.includes('FUNCTION pg_temp.credit_integrity_issues_legacy(')) {
      throw new Error('Unexpected historical integrity function schema');
    }
    await runMigrations(isolated.runtime.db, 'latest');
    historyAccountId = await seedSettledHistory(4_000, 'history');
    comparisonAccountId = await seedSettledHistory(500, 'comparison');
  }, 180_000);
  afterAll(async () => isolated?.close());

  test('audits 4,000 historical charges within the production two-second transaction deadline', async () => {
    const rows = await createCreditUnitOfWork(isolated.runtime.db, {
      cancelBackend: isolated.runtime.cancelBackend,
    }).execute(async transaction => {
      return (await sql<Issue>`SELECT * FROM credit_audit_account(${historyAccountId},false)`.execute(transaction)).rows;
    });
    expect(rows).toEqual([]);
    const account = await isolated.runtime.db.selectFrom('credit_accounts')
      .select(['integrity_blocked', 'integrity_issue_count']).where('account_id', '=', historyAccountId).executeTakeFirstOrThrow();
    expect(account.integrity_blocked).toBe(false);
    expect(String(account.integrity_issue_count)).toBe('0');
  });

  test.each(CORRUPTIONS)('preserves historical %s issue codes and counts', async (expectedCode, mutation) => {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('BEGIN');
      // Temporary, invoker-only oracle; both its creation and corruption are rolled back.
      await client.query(legacyDefinition);
      await client.query('REVOKE ALL ON FUNCTION pg_temp.credit_integrity_issues_legacy(text) FROM PUBLIC');
      expect((await client.query<Issue>('SELECT * FROM credit_integrity_issues($1)', [comparisonAccountId])).rows).toEqual([]);
      expect((await client.query<Issue>('SELECT * FROM pg_temp.credit_integrity_issues_legacy($1)', [comparisonAccountId])).rows).toEqual([]);
      // Only an administrator in an isolated database can bypass these write guards.
      await client.query("SET LOCAL session_replication_role='replica'");
      await client.query(mutation, [comparisonAccountId]);
      await client.query("SET LOCAL session_replication_role='origin'");
      const historical = await client.query<Issue>(
        'SELECT * FROM pg_temp.credit_integrity_issues_legacy($1) ORDER BY issue_code', [comparisonAccountId]);
      const current = await client.query<Issue>(
        'SELECT * FROM credit_integrity_issues($1) ORDER BY issue_code', [comparisonAccountId]);
      expect(historical.rows).toContainEqual({ issue_code: expectedCode, issue_count: '1' });
      expect(current.rows).toEqual(historical.rows);
      // The unrelated large account must remain clean.
      expect((await client.query<Issue>('SELECT * FROM credit_integrity_issues($1)', [historyAccountId])).rows).toEqual([]);
    } finally {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
  });

  async function seedSettledHistory(count: number, suffix: string): Promise<string> {
    const { accountId } = await seedCreditAccount(isolated.runtime.db, suffix);
    await grantCredits(isolated.runtime.db, { accountId, grantKey: 'initial', amount: 20_000 });
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('BEGIN');
      // Bulk-load a balanced historical fixture, without timing thousands of operator calls.
      // Terminal owners may have been pruned; only reserved orphan charges are invalid.
      await client.query("SET LOCAL session_replication_role='replica'");
      await client.query(`INSERT INTO credit_charges(id,account_id,operation_key,fingerprint,operation_type,
        source,price_version,quoted_amount,state,settled_amount,task_kind,task_id,deadline_at,completed_at)
        SELECT gen_random_uuid(),$1,'scale-'||n,'fp','bookmark.classify','web','bookmark-classify.v1',
          1,'settled',1,'classification_preview','scale-'||n,clock_timestamp()+interval '1 hour',clock_timestamp()
        FROM generate_series(1,$2::int) n`, [accountId, count]);
      await client.query(`INSERT INTO credit_allocations(account_id,charge_id,grant_id,amount)
        SELECT c.account_id,c.id,g.id,1 FROM credit_charges c JOIN credit_grants g ON g.account_id=c.account_id
        WHERE c.account_id=$1`, [accountId]);
      await client.query(`INSERT INTO credit_ledger_entries(account_id,sequence,event_key,fingerprint,kind,
        effective_at,points_delta,available_delta,reserved_delta,available_after,reserved_after,
        operation_type,source,reason_code,charge_id)
        SELECT $1,2*n,'reserve-'||n,'fp','reserve',clock_timestamp(),0,-1,1,20000-n,1,
          'bookmark.classify','web','classification_requested',id
        FROM credit_charges CROSS JOIN LATERAL (SELECT substring(task_id FROM 7)::int n) nums WHERE account_id=$1
        UNION ALL
        SELECT $1,2*n+1,'spend-'||n,'fp','spend',clock_timestamp(),-1,0,-1,20000-n,0,
          'bookmark.classify','web','classification_completed',id
        FROM credit_charges CROSS JOIN LATERAL (SELECT substring(task_id FROM 7)::int n) nums WHERE account_id=$1`, [accountId]);
      await client.query('UPDATE credit_grants SET spent_amount=$2 WHERE account_id=$1', [accountId, count]);
      await client.query('UPDATE credit_accounts SET last_sequence=$2 WHERE account_id=$1', [accountId, count * 2 + 1]);
      await client.query('COMMIT');
      await client.query('ANALYZE credit_charges');
      await client.query('ANALYZE credit_allocations');
      await client.query('ANALYZE credit_ledger_entries');
      return accountId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
});
