import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Expand Publisher receipts with the protocol's minimum replay window.
 * Completed rows become cleanup-eligible only after one full 24-hour day;
 * in-progress rows have no expiry and cannot match the cleanup index.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE publisher_idempotency
    ADD COLUMN result_expires_at timestamptz`.execute(db);

  await sql`UPDATE publisher_idempotency
    SET result_expires_at = completed_at + interval '1 day'
    WHERE completed_at IS NOT NULL`.execute(db);

  await sql`ALTER TABLE publisher_idempotency
    ADD CONSTRAINT publisher_receipt_replay_window
      CHECK (
        (completed_at IS NULL AND result_expires_at IS NULL)
        OR
        (completed_at IS NOT NULL AND result_expires_at IS NOT NULL
          AND result_expires_at >= completed_at + interval '1 day')
      )`.execute(db);

  await sql`CREATE INDEX publisher_receipt_expiry_idx
    ON publisher_idempotency (result_expires_at, namespace, principal_id, idempotency_key)
    WHERE completed_at IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS publisher_receipt_expiry_idx`.execute(db);
  await sql`ALTER TABLE publisher_idempotency
    DROP CONSTRAINT IF EXISTS publisher_receipt_replay_window,
    DROP COLUMN IF EXISTS result_expires_at`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
