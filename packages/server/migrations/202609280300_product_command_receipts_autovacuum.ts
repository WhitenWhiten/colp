import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Product command admission inserts a claim and then updates the same row to a
 * completed receipt. Later compaction updates it again. This table therefore
 * has the same high-churn profile as the outbox tables tuned in 202609260400,
 * but was accidentally omitted from that migration.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE product_command_receipts SET (
      autovacuum_vacuum_scale_factor = 0.02,
      autovacuum_analyze_scale_factor = 0.01
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE product_command_receipts RESET (
      autovacuum_vacuum_scale_factor,
      autovacuum_analyze_scale_factor
    )
  `.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
