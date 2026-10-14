import { sql, type Kysely } from 'kysely';

/** Daily capacity is a recoverable hold; the immutable per-job call limit is not. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_jobs
    ADD COLUMN budget_block_reason text CHECK (budget_block_reason IN ('daily','calls')),
    ADD COLUMN budget_retry_after timestamptz,
    ADD CONSTRAINT automation_budget_hold CHECK (coalesce(budget_block_reason='daily',false) = (budget_retry_after IS NOT NULL));
    UPDATE automation_jobs j SET
      budget_block_reason=CASE WHEN (SELECT count(*) FROM automation_job_attempts a WHERE a.job_id=j.id)>=j.max_calls THEN 'calls' ELSE 'daily' END,
      budget_retry_after=CASE WHEN (SELECT count(*) FROM automation_job_attempts a WHERE a.job_id=j.id)>=j.max_calls THEN NULL ELSE CURRENT_TIMESTAMP END
      WHERE state='blocked' AND explanation='Optional execution budget exhausted.';
    CREATE INDEX automation_budget_due ON automation_jobs(target_partition,budget_retry_after,id)
      WHERE state='blocked' AND budget_block_reason='daily';`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX automation_budget_due;
    ALTER TABLE automation_jobs DROP CONSTRAINT automation_budget_hold,DROP COLUMN budget_retry_after,DROP COLUMN budget_block_reason`.execute(db);
}
