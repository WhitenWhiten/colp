import { sql, type Kysely, type Migration } from 'kysely';

/**
 * P5-16 follow-up: give the due-delivery claim an index it can order by.
 *
 * The email worker's claim selects the earliest due row across two disjoint
 * conditions and orders by the due column. It was rewritten as a UNION ALL of
 * two index-ordered branches so each branch could walk its own index instead of
 * the planner sorting the whole channel, and that worked for the leased branch
 * (`notification_deliveries_leased_until_idx`).
 *
 * The pending/retryable branch still sorted, and the reason is the index, not
 * the predicate: `notification_deliveries_state_due_idx` is
 * `(state, next_attempt_at, delivery_id) WHERE state IN ('pending','retryable')`
 * and carries no `channel` column, while the claim also filters
 * `channel='email'`. An index can only supply an ordering for the rows the query
 * actually wants, and this one returns rows from every channel — so the planner
 * cannot use it for the order and falls back to `Seq Scan -> Sort` on a 2,500-row
 * due set (measured with plain EXPLAIN, no `enable_seqscan=off`).
 *
 * This adds the same index WITH `channel` leading, so the equality on channel
 * and the range on `next_attempt_at` are both satisfied while the index order
 * matches `order by next_attempt_at, delivery_id`.
 *
 * Concurrency: `CREATE INDEX` (not CONCURRENTLY) matches the surrounding
 * notification migrations; this table is written by the delivery worker, and the
 * migration runner holds the schema change in one transaction. On a large
 * installation the build is the cost, not the lock, because the partial predicate
 * keeps the index to the live delivery rows.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX IF NOT EXISTS notification_deliveries_channel_state_due_idx
    ON notification_deliveries(channel,next_attempt_at,delivery_id)
    WHERE state IN ('pending','retryable')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS notification_deliveries_channel_state_due_idx`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
