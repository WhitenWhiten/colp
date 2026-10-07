import { sql, type Kysely, type Migration } from 'kysely';

/**
 * CS-06 fix: the `community.rank-refresh` outbox event runs on the
 * `projection_latest_only` handler mode, whose claim gate requires a real
 * positive `commit_ordinal` on every claimed row. The event has no source
 * aggregate ordinal to borrow (the projection is a whole-surface rebuild,
 * not a per-aggregate stream), so this migration adds the dedicated
 * sequence the producer draws from inside the enqueue transaction:
 *
 *   community_rank_refresh_ordinal   bigint sequence, start 1
 *
 * Sequence ordinals are allocation-ordered, not commit-ordered; a
 * still-uncommitted lower ordinal can never block a later committed event,
 * and a late-committing lower ordinal is converged by the projection
 * watermark on claim (obsolete-skip), which is exactly the latest_only
 * contract the hot-ranking rebuild wants.
 *
 * Expand-only: one additive sequence, no existing object is weakened.
 * Empty `down` leaves the sequence in place, so `up` must be re-entrant
 * after Kysely forgets the migration row.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE SEQUENCE IF NOT EXISTS community_rank_refresh_ordinal START WITH 1`.execute(db);
}

/** Expand-only contract: production rollback is flag-off; never run migration down. */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // Intentionally empty. The additive sequence is retained for rollback safety.
}

export const migration: Migration = { up, down };
export default migration;
