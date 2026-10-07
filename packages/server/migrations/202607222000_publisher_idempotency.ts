import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Expand-only: Publisher durable idempotency store (ADR-0003).
 * Separate from product_command_receipts — PK is (namespace, principal_id, idempotency_key).
 * Fingerprint is not part of the unique winner key.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE publisher_idempotency (
    namespace text NOT NULL,
    principal_id text NOT NULL,
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL,
    target_identity text,
    result_status integer,
    result_headers jsonb,
    result_media_type text,
    result_bytes bytea,
    result_digest text,
    contract_version text NOT NULL DEFAULT '0.1.0-draft',
    claimed_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    PRIMARY KEY (namespace, principal_id, idempotency_key),
    CHECK (result_status IS NULL OR result_status BETWEEN 100 AND 599),
    CHECK (
      (completed_at IS NULL
        AND result_bytes IS NULL AND result_headers IS NULL AND result_media_type IS NULL
        AND result_status IS NULL AND result_digest IS NULL)
      OR
      (completed_at IS NOT NULL
        AND result_bytes IS NOT NULL AND result_headers IS NOT NULL
        AND result_media_type IS NOT NULL AND result_status IS NOT NULL
        AND result_digest IS NOT NULL)
    ),
    CHECK (result_digest IS NULL OR result_digest ~ '^[0-9a-f]{64}$')
  )`.execute(db);

  await sql`CREATE INDEX publisher_idempotency_principal_idx
    ON publisher_idempotency (principal_id, namespace)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS publisher_idempotency_principal_idx`.execute(db);
  await sql`DROP TABLE IF EXISTS publisher_idempotency`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
