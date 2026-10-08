import { sql, type Kysely, type Migration } from 'kysely';

/**
 * PGC-04 (2026-08-27 backend performance audit): per-table autovacuum tuning
 * for the high-churn tables. The default 20% vacuum scale factor lets the
 * outbox (constant claim/complete UPDATE+DELETE cycles), the feed fanout
 * (bulk INSERT + withdrawal + retention DELETE) and the notification tables
 * accumulate dead tuples and index bloat long before autovacuum wakes up;
 * 2% vacuum / 1% analyze keeps their partial claim indexes tight. Storage
 * parameters only affect autovacuum scheduling; N-1 binaries ignore them.
 */
const HIGH_CHURN_TABLES = [
  'outbox_events',
  'social_feed_items',
  'notifications',
  'notification_deliveries',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of HIGH_CHURN_TABLES) {
    await sql`
      ALTER TABLE ${sql.table(table)} SET (
        autovacuum_vacuum_scale_factor = 0.02,
        autovacuum_analyze_scale_factor = 0.01
      )
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [...HIGH_CHURN_TABLES].reverse()) {
    await sql`
      ALTER TABLE ${sql.table(table)} RESET (
        autovacuum_vacuum_scale_factor,
        autovacuum_analyze_scale_factor
      )
    `.execute(db);
  }
}

export const migration: Migration = { up, down };
export default migration;
