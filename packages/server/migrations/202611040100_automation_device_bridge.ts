import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE automation_device_requests (
    id text PRIMARY KEY, owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    replica_id text NOT NULL, replica_generation bigint NOT NULL, collection_id text NOT NULL,
    operation text NOT NULL, fingerprint text NOT NULL, input_json jsonb NOT NULL,
    state text NOT NULL CHECK (state IN ('pending','running','done','failed')),
    result_json jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '1 day');
    CREATE INDEX automation_device_requests_pending ON automation_device_requests(owner_id,replica_id,created_at)
      WHERE state IN ('pending','running');`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> { await sql`DROP TABLE automation_device_requests`.execute(db); }
