import { sql, type Kysely, type Migration } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE product_command_receipts
    ADD CONSTRAINT product_command_id_canonical_uuid_v4
      CHECK (command_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    ADD CONSTRAINT product_command_compact_result_consistency
      CHECK (
        (completed_at IS NULL AND compact_claim = false
          AND result_bytes IS NULL AND result_headers IS NULL AND result_media_type IS NULL
          AND result_status IS NULL AND result_digest IS NULL AND result_expires_at IS NULL
          AND result_purged_at IS NULL)
        OR
        (completed_at IS NOT NULL AND compact_claim = false
          AND result_bytes IS NOT NULL AND result_headers IS NOT NULL
          AND result_media_type IS NOT NULL AND result_status IS NOT NULL
          AND result_purged_at IS NULL)
        OR
        (completed_at IS NOT NULL AND compact_claim = true
          AND result_bytes IS NULL AND result_headers IS NULL AND result_media_type IS NULL
          AND result_status IS NULL AND result_purged_at IS NOT NULL)
      ),
    ADD CONSTRAINT product_command_full_result_retention
      CHECK (completed_at IS NULL OR (result_expires_at IS NOT NULL
        AND result_expires_at >= completed_at + interval '30 days')),
    ADD CONSTRAINT product_command_digest_format
      CHECK ((result_digest IS NULL OR result_digest ~ '^[0-9a-f]{64}$')
        AND (completed_at IS NULL OR result_digest IS NOT NULL))`.execute(db);
  await sql`CREATE INDEX product_command_receipt_expiry_idx ON product_command_receipts(result_expires_at) WHERE result_bytes IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS product_command_receipt_expiry_idx`.execute(db);
  await sql`ALTER TABLE product_command_receipts
    DROP CONSTRAINT IF EXISTS product_command_digest_format,
    DROP CONSTRAINT IF EXISTS product_command_full_result_retention,
    DROP CONSTRAINT IF EXISTS product_command_compact_result_consistency,
    DROP CONSTRAINT IF EXISTS product_command_id_canonical_uuid_v4`.execute(db);
}

export const migration: Migration = { up, down };
