import { sql, type Kysely, type Migration } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE outbox_events
    ADD COLUMN aggregate_type text,
    ADD COLUMN aggregate_id text,
    ADD COLUMN occurred_at timestamptz,
    ADD COLUMN dead_lettered_at timestamptz`.execute(db);

  // Expand/contract: preserve legacy rows with deterministic synthetic identity until
  // all producers emit the full envelope. N/N-1 consumers can continue reading them.
  await sql`UPDATE outbox_events
    SET aggregate_type = COALESCE(aggregate_type, 'legacy'),
        aggregate_id = COALESCE(aggregate_id, outbox_id),
        occurred_at = COALESCE(occurred_at, available_at, CURRENT_TIMESTAMP),
        dead_lettered_at = CASE WHEN state = 'dead_letter' THEN COALESCE(dead_lettered_at, CURRENT_TIMESTAMP) ELSE dead_lettered_at END
    WHERE aggregate_type IS NULL OR aggregate_id IS NULL OR occurred_at IS NULL`.execute(db);

  await sql`ALTER TABLE outbox_events
    ALTER COLUMN aggregate_type SET NOT NULL,
    ALTER COLUMN aggregate_id SET NOT NULL,
    ALTER COLUMN occurred_at SET NOT NULL,
    ADD CONSTRAINT outbox_aggregate_type_length CHECK (length(aggregate_type) BETWEEN 1 AND 64),
    ADD CONSTRAINT outbox_aggregate_id_length CHECK (length(aggregate_id) BETWEEN 1 AND 256)`.execute(db);

  await sql`CREATE INDEX outbox_expired_lease_idx
    ON outbox_events(locked_until) WHERE state = 'leased'`.execute(db);
  await sql`CREATE TABLE outbox_projection_watermarks (
    handler_name text NOT NULL,
    aggregate_scope text NOT NULL,
    commit_ordinal bigint NOT NULL CHECK (commit_ordinal > 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (handler_name, aggregate_scope)
  )`.execute(db);
  await sql`CREATE TABLE outbox_delivery_receipts (
    handler_name text NOT NULL,
    domain_event_id text NOT NULL,
    delivered_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (handler_name, domain_event_id)
  )`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS outbox_delivery_receipts`.execute(db);
  await sql`DROP TABLE IF EXISTS outbox_projection_watermarks`.execute(db);
  await sql`DROP INDEX IF EXISTS outbox_expired_lease_idx`.execute(db);
  await sql`ALTER TABLE outbox_events
    DROP CONSTRAINT IF EXISTS outbox_aggregate_type_length,
    DROP CONSTRAINT IF EXISTS outbox_aggregate_id_length,
    DROP COLUMN IF EXISTS dead_lettered_at,
    DROP COLUMN IF EXISTS occurred_at,
    DROP COLUMN IF EXISTS aggregate_id,
    DROP COLUMN IF EXISTS aggregate_type`.execute(db);
}

const migration: Migration = { up, down };
export default migration;
