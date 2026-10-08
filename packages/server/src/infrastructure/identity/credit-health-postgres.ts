import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import { createCreditUnitOfWork } from './credits-postgres.js';

interface CreditHealthMetrics {
  increment(name: string, value?: number): void;
  gauge(name: string, value: number): void;
}

/** Bounded account sweep. Each audit owns its own L0/L1 transaction. */
export function createPostgresCreditHealthObserver(db: Kysely<DatabaseSchema>, metrics: CreditHealthMetrics): () => Promise<void> {
  let afterAccountId = '';
  let summaryAfter = 0;
  return async () => {
    if (Date.now() >= summaryAfter) {
      summaryAfter = Date.now() + 60_000;
      try { await observeSummary(db, metrics); }
      catch { metrics.increment('classification.credits.summary_failed'); }
    }
    const accounts = await db.selectFrom('credit_accounts').select('account_id')
      .where('account_id', '>', afterAccountId).orderBy('account_id').limit(10).execute();
    if (!accounts.length) { afterAccountId = ''; return; }
    for (const account of accounts) {
      try {
        const issues = await createCreditUnitOfWork(db).execute(async tx => {
          const result = await sql<{ issue_code: string; issue_count: string }>`SELECT * FROM credit_audit_account(${account.account_id},false)`.execute(tx);
          return result.rows;
        });
        if (issues.length) metrics.increment('classification.credits.integrity_alerts', issues.reduce((total, issue) => total + Number(issue.issue_count), 0));
      } catch {
        metrics.increment('classification.credits.audit_failed');
      }
      afterAccountId = account.account_id;
    }
    metrics.gauge('classification.credits.last_audit_at_seconds', Date.now() / 1000);
  };
}

async function observeSummary(db: Kysely<DatabaseSchema>, metrics: CreditHealthMetrics): Promise<void> {
  const summary = await createCreditUnitOfWork(db).execute(async tx => {
    const result = await sql<Record<string, string>>`WITH ledger AS (
      SELECT count(*) FILTER (WHERE kind='reserve')::text AS reserved_total,
        count(*) FILTER (WHERE kind='spend')::text AS settled_total,
        count(*) FILTER (WHERE kind='release')::text AS released_total FROM credit_ledger_entries
    ), holds AS (
      SELECT count(*)::text AS outstanding_holds,
        coalesce(extract(epoch FROM clock_timestamp()-min(created_at)),0)::text AS oldest_hold_seconds
        FROM credit_charges WHERE state='reserved'
    ), accounts AS (
      SELECT count(*) FILTER (WHERE integrity_blocked)::text AS blocked_accounts,
        coalesce(sum(integrity_issue_count),0)::text AS inconsistencies FROM credit_accounts
    ) SELECT ledger.*, holds.*, accounts.*,
      (SELECT count(*) FROM product_command_receipts WHERE command_scope IN
        ('collections:classification-preview:v1','collections:classification-run-create:v1') AND result_status=409
        AND position('"code":"insufficient_credits"' in convert_from(result_bytes,'UTF8'))>0)::text AS insufficient_retained_receipts
      FROM ledger CROSS JOIN holds CROSS JOIN accounts`.execute(tx);
    return result.rows[0]!;
  });
  for (const [key, value] of Object.entries(summary)) metrics.gauge(`classification.credits.${key}`, Number(value));
}
