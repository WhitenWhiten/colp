import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Expand-only Collection Collaboration invite email deliveries (SC-04).
 *
 * Each pending invite owns exactly one delivery row. N-1 binaries ignore the
 * table. Application rollback leaves it installed. `down` drops only this
 * table and is developer-only.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE collection_invite_deliveries (
      delivery_id     text PRIMARY KEY,
      invite_id       text NOT NULL UNIQUE REFERENCES collection_invites(id) ON DELETE RESTRICT,
      state           text NOT NULL CHECK (
                        state IN ('pending','leased','retryable','delivered','suppressed','dead_letter')
                      ),
      attempt_count   integer NOT NULL CHECK (attempt_count >= 0),
      state_revision  bigint NOT NULL CHECK (state_revision > 0),
      next_attempt_at timestamptz NOT NULL,
      leased_until    timestamptz NULL,
      delivered_at    timestamptz NULL,
      suppressed_at   timestamptz NULL,
      dead_lettered_at timestamptz NULL,
      last_error_category text NULL CHECK (last_error_category IN (
                        'unknown_future_version','invalid_contract','retry_exhausted',
                        'dependency','provider_unavailable','other','not_configured'
                      )),
      provider_message_id text NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE INDEX collection_invite_deliveries_due_idx
      ON collection_invite_deliveries (next_attempt_at)
      WHERE state IN ('pending','retryable')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS collection_invite_deliveries`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
