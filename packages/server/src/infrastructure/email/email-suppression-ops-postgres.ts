import type { Pool } from 'pg';
import type {
  EmailSuppressionFactRecord,
  EmailSuppressionOpsRepository,
} from '../../modules/email/index.js';

interface SuppressionRow {
  recipient_account_id: string;
  source: EmailSuppressionFactRecord['source'];
  occurred_at: Date;
  created_at: Date;
}

/**
 * P5-31 production suppression ops repository over
 * `notification_email_suppressions` (migration 202608020800).
 *
 * The SELECT never joins to `accounts.email` and returns only the opaque
 * account id + source + timestamps, so ops output stays PII-safe (gate doc
 * D10). Clear deletes the durable fact (documented as resubscribe; aligns
 * with the provider UnblockRecipient semantics) and never touches
 * notification_preferences or Notification authority rows.
 */
export function createPostgresEmailSuppressionOpsRepository(pool: Pool): EmailSuppressionOpsRepository {
  return Object.freeze({
    async countSuppressionFacts(): Promise<number> {
      const result = await pool.query<{ count: string }>('select count(*)::text as count from notification_email_suppressions');
      const count = Number(result.rows[0]?.count);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid suppression fact count');
      return count;
    },
    async listSuppressionFacts(): Promise<readonly EmailSuppressionFactRecord[]> {
      const result = await pool.query<SuppressionRow>(`select recipient_account_id, source,
          occurred_at, created_at
        from notification_email_suppressions
        order by occurred_at, recipient_account_id`);
      return Object.freeze(result.rows.map((row) => Object.freeze({
        recipientAccountId: row.recipient_account_id,
        source: row.source,
        occurredAt: row.occurred_at,
        createdAt: row.created_at,
      })));
    },
    async clearSuppressionFact(recipientAccountId: string): Promise<boolean> {
      const result = await pool.query(`delete from notification_email_suppressions
        where recipient_account_id=$1`, [recipientAccountId]);
      return result.rowCount === 1;
    },
  });
}
